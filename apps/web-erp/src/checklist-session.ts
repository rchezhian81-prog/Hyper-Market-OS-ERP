// The manager CHECKLIST screen — the "did the shift actually open/close, and what is still outstanding" desk
// (M25-FR-02 · API-11 · P-03 control-by-exception · P-04 least privilege · P-05 human-governed · P-08 no silent
// failure). The durable checklist store (services/finance/src/checklist-store.ts) persists a submitted
// opening/closing/handover checklist and folds it through the tested `assessChecklist` engine
// (`GET /v1/hr/workforce/checklists`). This is the screen a manager works it from: every checklist the day has —
// worst first — and the one action taken from here, SIGN AND SUBMIT a checklist in the manager's own name.
//
// Truths the surface must carry, all already true in the engine and re-stated so the screen cannot weaken them:
//   • **Blocking and non-blocking are separated** (the engine's governing principle, P-03). A checklist with a
//     BLOCKING item still outstanding is `blocked_item` — the shop cannot run — and reads as an error tone; a
//     signed checklist with only non-blocking items left is `complete` and carries them, visible, into the next
//     handover; a checklist with nobody's name on it is `not_signed` ("a list, not a record"), never treated as
//     done. Colour is never the only signal (an icon + a word ride with every tone).
//   • **Signing needs the manage permission** (§28 / P-04 least privilege). A viewer with only
//     `workforce.checklist.read` sees the checklists but is offered no submit control; the write needs
//     `workforce.roster.manage`, enforced here AND at the cloud route. Nothing is signed automatically — this
//     records what a manager decided (hard rule #5: no AI signs a checklist), and a box never told who is at the
//     screen can sign nothing at all.
//   • **It self-heals.** The worklist is re-READ from the cloud, so a freshly-signed checklist re-reads with its
//     new state; this screen never carries a "done" flag that can go stale against reality. And a day the box was
//     never told is `not known`, never "no checklists" (P-08).
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives; the shell only renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import { assessChecklist, type ChecklistItem, type ChecklistOutcome, type ChecklistResult } from '../../../packages/workforce/src/workforce';

/** One checklist as the box last read it: its id, kind, items (as ticked), and who has signed (if anyone). The
 *  shape `GET /v1/hr/workforce/checklists` hands each row over (minus the server-computed assessment, which the
 *  session recomputes from the tested engine so the screen cannot drift from it). */
export interface StoredChecklist {
  readonly checklistId: string;
  readonly kind: 'opening' | 'closing' | 'handover';
  readonly items: readonly ChecklistItem[];
  readonly signedBy?: string;
  readonly branchId?: string;
  readonly forDate?: string;
}

/** The checklist worklist the shell last read: the day's checklists. Empty means the day was clean; absent means
 *  the box was never told. */
export interface ChecklistData {
  readonly checklists: readonly StoredChecklist[];
}

/** The outcome of a submit — recorded, refused by the server (permission / unreadable), or a lost link. */
export type SubmitResult = 'recorded' | 'refused' | 'lost_link';

/** The authenticated POST of a manager's signed checklist. Injected, so the model never opens a socket itself;
 *  the server records it in the caller's own name (`POST /v1/hr/workforce/checklists/:checklistId`) and
 *  re-checks `workforce.roster.manage`. */
export interface SubmitChecklistPort {
  post(input: {
    readonly checklistId: string;
    readonly kind: 'opening' | 'closing' | 'handover';
    readonly items: readonly ChecklistItem[];
    readonly signedBy: string;
    readonly branchId?: string;
    readonly forDate?: string;
  }): Promise<SubmitResult>;
}

export interface ChecklistPorts {
  /** The checklist worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): ChecklistData;
  /** Whether this user may read the checklists (`workforce.checklist.read`). */
  mayRead(): boolean;
  /** Whether this user may sign/submit a checklist (`workforce.roster.manage`). */
  mayManage(): boolean;
  /** Records a signed checklist. Only reached from the explicit action, never on render. */
  submitPort(): SubmitChecklistPort;
}

export interface ChecklistConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'listHeading' | 'toWorkCount' | 'allDone' | 'notKnown'
  | 'kindOpening' | 'kindClosing' | 'kindHandover'
  | 'itemsLabel' | 'blockingWord' | 'outstandingLabel' | 'signedByLabel' | 'unsignedWord'
  | 'blockedWord' | 'incompleteWord' | 'completeWord'
  | 'submitHeading' | 'whichLabel' | 'signSubmitBtn' | 'tickHint' | 'noneToSign'
  | 'submitRecorded' | 'submitRefused' | 'submitLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noManage'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const CHECKLIST_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Checklists', langName: 'தமிழ்',
    lead: 'The opening, closing and handover checklists for the day — worst first — waiting for a manager to sign them off. A BLOCKING item still outstanding stops the shop; a checklist with nobody\'s name on it is a list, not a record. Signing records who signed, in your name; nothing is signed automatically.',
    listHeading: 'To sign off', toWorkCount: 'to sign off', allDone: 'Every checklist is signed and nothing blocking is outstanding.',
    notKnown: 'This store computer has not been told the day\'s checklists yet, so it cannot say what is outstanding.',
    kindOpening: 'Opening', kindClosing: 'Closing', kindHandover: 'Handover',
    itemsLabel: 'Items', blockingWord: 'Blocking', outstandingLabel: 'Still outstanding', signedByLabel: 'Signed by', unsignedWord: 'Not signed',
    blockedWord: 'Blocked', incompleteWord: 'Carried', completeWord: 'Done',
    submitHeading: 'Sign off a checklist', whichLabel: 'Which checklist', signSubmitBtn: 'Sign and submit', tickHint: 'Tick the items you have verified, then sign.',
    noneToSign: 'Nothing here to sign — every checklist is complete.',
    submitRecorded: 'Signed and recorded.',
    submitRefused: 'Could not record — a blocking item is still outstanding, or you do not have permission to sign the checklist.',
    submitLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the day\'s checklists', scrEmpty: 'Every checklist is signed and nothing blocking is outstanding.',
    stateNotPermitted: 'You do not have permission to see the checklists.',
    noManage: 'You can see the checklists, but signing one needs manager permission.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'சரிபார்ப்புப் பட்டியல்கள்', langName: 'English',
    lead: 'அன்றைய திறப்பு, மூடல், ஒப்படைப்பு சரிபார்ப்புப் பட்டியல்கள் — மோசமானது முதலில் — மேலாளர் கையொப்பமிடக் காத்திருக்கின்றன. நிலுவையில் உள்ள ஒரு தடையான உருப்படி கடையை நிறுத்தும்; யாருடைய பெயரும் இல்லாத பட்டியல் ஒரு பதிவு அல்ல, வெறும் பட்டியல். கையொப்பம் யார் கையொப்பமிட்டார்கள் என்பதை உங்கள் பெயரில் பதிவு செய்கிறது; எதுவும் தானாக கையொப்பமிடப்படாது.',
    listHeading: 'கையொப்பமிட வேண்டியவை', toWorkCount: 'கையொப்பமிட', allDone: 'ஒவ்வொரு பட்டியலும் கையொப்பமிடப்பட்டு, தடையான எதுவும் நிலுவையில் இல்லை.',
    notKnown: 'அன்றைய சரிபார்ப்புப் பட்டியல்கள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை, எனவே என்ன நிலுவையில் உள்ளது என்று சொல்ல முடியாது.',
    kindOpening: 'திறப்பு', kindClosing: 'மூடல்', kindHandover: 'ஒப்படைப்பு',
    itemsLabel: 'உருப்படிகள்', blockingWord: 'தடையானது', outstandingLabel: 'இன்னும் நிலுவையில்', signedByLabel: 'கையொப்பமிட்டவர்', unsignedWord: 'கையொப்பமிடப்படவில்லை',
    blockedWord: 'தடைபட்டது', incompleteWord: 'எடுத்துச் செல்லப்பட்டது', completeWord: 'முடிந்தது',
    submitHeading: 'ஒரு பட்டியலைக் கையொப்பமிடு', whichLabel: 'எந்தப் பட்டியல்', signSubmitBtn: 'கையொப்பமிட்டு சமர்ப்பி', tickHint: 'நீங்கள் சரிபார்த்த உருப்படிகளைக் குறியிடவும், பிறகு கையொப்பமிடவும்.',
    noneToSign: 'கையொப்பமிட எதுவும் இல்லை — ஒவ்வொரு பட்டியலும் முழுமையானது.',
    submitRecorded: 'கையொப்பமிடப்பட்டு பதிவு செய்யப்பட்டது.',
    submitRefused: 'பதிவு செய்ய முடியவில்லை — ஒரு தடையான உருப்படி இன்னும் நிலுவையில் உள்ளது, அல்லது பட்டியலைக் கையொப்பமிட உங்களுக்கு அனுமதி இல்லை.',
    submitLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'அன்றைய சரிபார்ப்புப் பட்டியல்களைக் காட்டுகிறது', scrEmpty: 'ஒவ்வொரு பட்டியலும் கையொப்பமிடப்பட்டு, தடையான எதுவும் நிலுவையில் இல்லை.',
    stateNotPermitted: 'சரிபார்ப்புப் பட்டியல்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    noManage: 'பட்டியல்களைப் பார்க்கலாம், ஆனால் ஒன்றைக் கையொப்பமிட மேலாளர் அனுமதி தேவை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(CHECKLIST_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

/** One outstanding item to show under a checklist — its words and whether it is a blocking one. */
export interface PresentedItem {
  readonly itemId: string;
  readonly description: string;
  readonly blocking: boolean;
  readonly done: boolean;
}

export interface PresentedChecklist {
  readonly checklistId: string;
  readonly kind: 'opening' | 'closing' | 'handover';
  /** The bilingual kind name (Opening / Closing / Handover). */
  readonly kindLabel: string;
  readonly outcome: ChecklistOutcome;
  readonly complete: boolean;
  readonly signedBy: string | null;
  /** Every item, so the shell can offer them to tick; outstanding ones are called out. */
  readonly items: readonly PresentedItem[];
  readonly outstanding: readonly PresentedItem[];
  /** The manager-readable sentence from the engine. */
  readonly detail: string;
  /** "Blocked" / "Not signed" / "Carried" / "Done" — a word, never colour alone. */
  readonly severityWord: string;
  /** blocked_item → error; not_signed / incomplete → warning; complete → ok. */
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
}

export interface ChecklistView {
  readonly screenState: StatusPresentation;
  readonly checklists: readonly PresentedChecklist[];
  /** Checklists that still need a manager (not complete). */
  readonly toWorkCount: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the sign-off action — this user holds `workforce.roster.manage`. */
  readonly mayManage: boolean;
}

export interface ChecklistSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): ChecklistView;
  /** Sign off a checklist in the manager's name — a HUMAN write. Ticks the given items done (never un-ticks one
   *  a shift already did), signs with the caller's name, and records it. Runs only from an explicit action,
   *  never on render; refuses BEFORE any POST without the manage permission, when the box was not told who is
   *  signing, or when the checklist is not one it holds (the server re-checks and refuses a blocking item too). */
  submit(checklistId: string, doneItemIds: readonly string[], sign: boolean): Promise<SubmitResult>;
  /** Present a submit outcome as one glanceable status the shell shows after the action. */
  presentSubmitResult(lang: Lang, result: SubmitResult): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayManage: boolean): ChecklistView => ({
  screenState, checklists: [], toWorkCount: 0, nobodyNamed, mayManage,
});

/** Worst first: a blocked checklist before an unsigned one before one merely carrying items before a done one. */
const RANK: Readonly<Record<ChecklistOutcome, number>> = Object.freeze({
  blocked_item: 0, not_signed: 1, incomplete: 2, complete: 3,
});

const KIND_KEY: Readonly<Record<'opening' | 'closing' | 'handover', CopyKey>> = Object.freeze({
  opening: 'kindOpening', closing: 'kindClosing', handover: 'kindHandover',
});

const SEVERITY_KEY: Readonly<Record<ChecklistOutcome, CopyKey>> = Object.freeze({
  blocked_item: 'blockedWord', not_signed: 'unsignedWord', incomplete: 'incompleteWord', complete: 'completeWord',
});

export function createChecklistSession(config: ChecklistConfig, ports: ChecklistPorts): ChecklistSession {
  const text = (lang: Lang, key: CopyKey): string => translator(CHECKLIST_COPY, lang)(key);

  const present = (lang: Lang, stored: StoredChecklist): PresentedChecklist => {
    const t = translator(CHECKLIST_COPY, lang);
    const result: ChecklistResult = assessChecklist({
      checklistId: stored.checklistId, kind: stored.kind, items: stored.items,
      ...(stored.signedBy === undefined ? {} : { signedBy: stored.signedBy }),
    });
    const items: PresentedItem[] = stored.items.map((i) => ({
      itemId: i.itemId, description: i.description, blocking: i.blocking, done: i.done,
    }));
    const outstanding: PresentedItem[] = result.outstanding.map((i) => ({
      itemId: i.itemId, description: i.description, blocking: i.blocking, done: i.done,
    }));
    // blocked_item shouts loudest (error); not_signed / incomplete are attention (warning); complete is ok.
    const tone = result.outcome === 'blocked_item' ? 'error' : result.outcome === 'complete' ? 'ok' : 'degraded';
    const icon = result.outcome === 'blocked_item' ? '✕' : result.outcome === 'complete' ? '✓' : '⚠';
    const severityWord = t(SEVERITY_KEY[result.outcome]);
    const kindLabel = t(KIND_KEY[stored.kind]);
    return {
      checklistId: stored.checklistId,
      kind: stored.kind,
      kindLabel,
      outcome: result.outcome,
      complete: result.complete,
      signedBy: stored.signedBy ?? null,
      items,
      outstanding,
      detail: result.detail,
      severityWord,
      status: presentStatus({
        tone,
        icon,
        label: `${severityWord} · ${kindLabel}`,
        announcement: result.detail,
        needsAttention: result.outcome !== 'complete',
      }),
      needsAttention: result.outcome !== 'complete',
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(CHECKLIST_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayManage = ports.mayManage();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayManage);
      }

      const data = ports.worklist();
      // Worst first: a blocked checklist before an unsigned one, then by kind so a day reads open→close→handover.
      const checklists = data.checklists
        .slice()
        .map((c) => present(lang, c))
        .sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || a.kind.localeCompare(b.kind));
      const toWorkCount = checklists.filter((c) => !c.complete).length;
      // "empty" only when there is genuinely nothing left to work — a signed, unblocked day.
      const state = checklists.length === 0 || toWorkCount === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        checklists,
        toWorkCount,
        nobodyNamed,
        mayManage,
      };
    },

    // Sign off a checklist. Refuse BEFORE any POST — no permission, nobody named, or a checklist the box does not
    // hold is a local refusal, not a round trip. The given items are ticked done (a shift's existing tick is
    // never un-done — done stays done); the caller's name signs it. The server re-checks the permission and
    // refuses a blocking item still outstanding, and records it in the manager's own name (hard rule #5).
    submit: async (checklistId, doneItemIds, sign) => {
      if (!ports.mayManage()) return 'refused';
      if (sign && config.userId === null) return 'refused'; // a checklist cannot be signed by nobody
      const data = ports.worklist();
      const stored = data.checklists.find((c) => c.checklistId === checklistId);
      if (stored === undefined) return 'refused';
      const ticked = new Set(doneItemIds);
      const items: ChecklistItem[] = stored.items.map((i) => (i.done || !ticked.has(i.itemId) ? i : { ...i, done: true }));
      return ports.submitPort().post({
        checklistId,
        kind: stored.kind,
        items,
        signedBy: sign ? (config.userId as string) : (stored.signedBy ?? ''),
        ...(stored.branchId === undefined ? {} : { branchId: stored.branchId }),
        ...(stored.forDate === undefined ? {} : { forDate: stored.forDate }),
      });
    },

    presentSubmitResult: (lang, result) => {
      const t = translator(CHECKLIST_COPY, lang);
      if (result === 'recorded') return presentStatus({ tone: 'ok', icon: '✓', label: t('submitRecorded'), needsAttention: false });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('submitLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('submitRefused'), needsAttention: true });
    },
  };
}
