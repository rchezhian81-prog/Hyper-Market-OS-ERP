// The day-reopen screen — the controlled, audited unlock of a locked trading day (M14-FR-04 · API-05 ·
// P-03 control-by-exception · §28 separation of duties). A day closes and LOCKS at the store box; once in a
// while an error is found the next morning and the day must be reopened to correct it. This is the screen an
// accountant/owner works that from: the locked days (most recent first) read live from the cloud
// (`GET /v1/pos/day-close`), and the one action taken here — REOPEN a locked day, with a stated reason and a
// NAMED approver who is a different person (§28).
//
// Three truths the screen must carry, all already enforced deeper and re-stated here so the surface cannot
// weaken them:
//   • **A different person approves it** (§28 / P-03). The reopener is the authenticated caller; the approver
//     they name may NEVER be themselves. The box's engine refuses a self-approval, and the cloud re-verifies
//     the approver genuinely holds the authority — but the screen refuses a self-approval locally too, before
//     any POST, so the reopener is told plainly rather than round-tripping to a refusal.
//   • **A reason is required, and nothing is deleted** (hard rule #2). A reopen is audited; it records the
//     reason + approver against the day and is a new compensating event — it never edits the close.
//   • **The reopen goes to the BOX** (`POST /lane/day-reopen`), the only place that can perform it (it holds
//     the locked day and re-queues the reopen). The worklist is read from the cloud; the write is to the box.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. No AI reopens a day (hard rule #5).

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** One locked trading day as the worklist route hands it over (`GET /v1/pos/day-close`, the rows with
 *  `locked: true`). Who closed it rides along for the audit trail and for reading. */
export interface LockedDayView {
  readonly dayCloseId: string;
  readonly tradingDay: string;
  readonly closedBy: string;
  readonly closedAt: string;
}

/** The worklist body — only the still-LOCKED days are worked here; the port filters out the already-reopened
 *  ones (a reopened day is open again) before handing them over. */
export interface DayReopenData {
  readonly lockedCount: number;
  readonly locked: readonly LockedDayView[];
}

/** The outcome of a reopen — recorded, refused (server or a local §28/validation refusal), or a lost link. */
export type ReopenResult =
  | 'reopened'
  | 'refused_self_approval'
  | 'reason_required'
  | 'approver_required'
  | 'refused'
  | 'lost_link';

/** The authenticated POST of a reopen. Injected, so the model never opens a socket itself; the box performs
 *  the reopen (enforcing §28: approver ≠ reopener) and the cloud re-verifies the approver's authority. */
export interface DayReopenPort {
  post(input: { readonly dayCloseId: string; readonly reason: string; readonly approvedBy: string }): Promise<ReopenResult>;
}

export interface DayReopenPorts {
  /** The locked-day worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): DayReopenData;
  /** Whether this user may read the locked days (`till.dayclose.read`). */
  mayRead(): boolean;
  /** Whether this user may reopen a day (`till.dayclose.approve`). */
  mayReopen(): boolean;
  /** Records a reopen. Only reached from the explicit action, never on render. */
  reopenPort(): DayReopenPort;
}

export interface DayReopenConfig {
  /** Who is reopening. `null` means the box was not told who is at the screen; when known, it is used for the
   *  local §28 check — the named approver may not be the reopener themselves. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'lockedHeading' | 'lockedCount' | 'allClear'
  | 'dayLabel' | 'closedByLabel' | 'closedAtLabel'
  | 'reopenHeading' | 'dayField' | 'reasonLabel' | 'reasonPlaceholder' | 'approverLabel' | 'approverPlaceholder' | 'reopenBtn'
  | 'reopenRecorded' | 'reopenRefused' | 'reopenSelf' | 'reopenReasonRequired' | 'reopenApproverRequired' | 'reopenLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noReopen'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const DAY_REOPEN_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Reopen a locked day', langName: 'தமிழ்',
    lead: 'Trading days that were closed and LOCKED — most recent first. Reopen one only to correct an error found afterwards. A reopen is recorded with your reason and must be approved by a DIFFERENT authorised person (separation of duties); it never erases the close — it is a new correcting entry.',
    lockedHeading: 'Locked days', lockedCount: 'locked',
    allClear: 'No locked days to reopen.',
    dayLabel: 'Trading day', closedByLabel: 'Closed by', closedAtLabel: 'Closed at',
    reopenHeading: 'Reopen a day', dayField: 'Which day', reasonLabel: 'Reason (required)',
    reasonPlaceholder: 'Why this locked day must be reopened.',
    approverLabel: 'Approved by (a different person)', approverPlaceholder: 'The authorised person who approved this reopen.',
    reopenBtn: 'Reopen the day',
    reopenRecorded: 'The day is reopened.',
    reopenRefused: 'Could not reopen — you may not have permission, or the approver is not authorised. Nothing was changed.',
    reopenSelf: 'You cannot approve your own reopen — a different authorised person must approve it (separation of duties).',
    reopenReasonRequired: 'A reopen needs a reason. Nothing was changed.',
    reopenApproverRequired: 'Name the different person who approved this reopen. Nothing was changed.',
    reopenLostLink: 'No connection to the store computer — not saved. Try again.',
    scrReady: 'Showing the locked days', scrEmpty: 'No locked days to reopen.',
    stateNotPermitted: 'You do not have permission to see the locked days.',
    noReopen: 'You can see the locked days, but reopening one needs approval authority.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'மூடிய நாளை மீண்டும் திற', langName: 'English',
    lead: 'மூடப்பட்டு பூட்டப்பட்ட வர்த்தக நாட்கள் — சமீபத்தியது முதலில். பின்னர் கண்டறியப்பட்ட பிழையைச் சரிசெய்யவே ஒரு நாளை மீண்டும் திறக்கவும். மீண்டும் திறப்பது உங்கள் காரணத்துடன் பதிவாகும், மேலும் வேறொரு அங்கீகரிக்கப்பட்ட நபரால் அங்கீகரிக்கப்பட வேண்டும் (பொறுப்புப் பிரிப்பு); அது மூடலை அழிக்காது — இது ஒரு புதிய திருத்தப் பதிவு.',
    lockedHeading: 'பூட்டிய நாட்கள்', lockedCount: 'பூட்டியவை',
    allClear: 'மீண்டும் திறக்க பூட்டிய நாட்கள் இல்லை.',
    dayLabel: 'வர்த்தக நாள்', closedByLabel: 'மூடியவர்', closedAtLabel: 'மூடிய நேரம்',
    reopenHeading: 'ஒரு நாளை மீண்டும் திற', dayField: 'எந்த நாள்', reasonLabel: 'காரணம் (தேவை)',
    reasonPlaceholder: 'இந்த பூட்டிய நாளை ஏன் மீண்டும் திறக்க வேண்டும்.',
    approverLabel: 'அங்கீகரித்தவர் (வேறொருவர்)', approverPlaceholder: 'இந்த மீள்திறப்பை அங்கீகரித்த அங்கீகரிக்கப்பட்ட நபர்.',
    reopenBtn: 'நாளை மீண்டும் திற',
    reopenRecorded: 'நாள் மீண்டும் திறக்கப்பட்டது.',
    reopenRefused: 'மீண்டும் திறக்க முடியவில்லை — உங்களுக்கு அனுமதி இல்லாமல் இருக்கலாம், அல்லது அங்கீகரித்தவருக்கு அதிகாரம் இல்லை. எதுவும் மாற்றப்படவில்லை.',
    reopenSelf: 'உங்கள் சொந்த மீள்திறப்பை நீங்களே அங்கீகரிக்க முடியாது — வேறொரு அங்கீகரிக்கப்பட்ட நபர் அங்கீகரிக்க வேண்டும் (பொறுப்புப் பிரிப்பு).',
    reopenReasonRequired: 'மீண்டும் திறக்க ஒரு காரணம் தேவை. எதுவும் மாற்றப்படவில்லை.',
    reopenApproverRequired: 'இந்த மீள்திறப்பை அங்கீகரித்த வேறு நபரைக் குறிப்பிடவும். எதுவும் மாற்றப்படவில்லை.',
    reopenLostLink: 'கடை கணினியுடன் இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'பூட்டிய நாட்களைக் காட்டுகிறது', scrEmpty: 'மீண்டும் திறக்க பூட்டிய நாட்கள் இல்லை.',
    stateNotPermitted: 'பூட்டிய நாட்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    noReopen: 'பூட்டிய நாட்களைப் பார்க்கலாம், ஆனால் ஒன்றை மீண்டும் திறக்க அங்கீகார அதிகாரம் தேவை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(DAY_REOPEN_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedLockedDay {
  readonly dayCloseId: string;
  readonly tradingDay: string;
  readonly closedBy: string;
  readonly closedAt: string;
  /** A locked day is a normal, settled state — an OK tone with an icon and word (colour is never alone). */
  readonly status: StatusPresentation;
}

export interface DayReopenView {
  readonly screenState: StatusPresentation;
  readonly locked: readonly PresentedLockedDay[];
  readonly lockedCount: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the reopen action — this user holds `till.dayclose.approve`. */
  readonly mayReopen: boolean;
}

export interface DayReopenSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): DayReopenView;
  /** Reopen a locked day, in the reopener's name — a HUMAN write. Runs only from an explicit action, never on
   *  render; refuses BEFORE any POST without permission, without a reason, without a named approver, or when
   *  the named approver is the reopener themselves (§28 — the box and cloud enforce it too; the screen never
   *  sends a self-approval). */
  reopen(dayCloseId: string, reason: string, approverId: string): Promise<ReopenResult>;
  /** Present a reopen outcome as one glanceable status the shell shows after the action. */
  presentReopenResult(lang: Lang, result: ReopenResult): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayReopen: boolean): DayReopenView => ({
  screenState, locked: [], lockedCount: 0, nobodyNamed, mayReopen,
});

export function createDayReopenSession(config: DayReopenConfig, ports: DayReopenPorts): DayReopenSession {
  const text = (lang: Lang, key: CopyKey): string => translator(DAY_REOPEN_COPY, lang)(key);

  const present = (lang: Lang, r: LockedDayView): PresentedLockedDay => {
    const t = translator(DAY_REOPEN_COPY, lang);
    return {
      dayCloseId: r.dayCloseId,
      tradingDay: r.tradingDay,
      closedBy: r.closedBy,
      closedAt: r.closedAt,
      // A locked day is the correct, settled state — not a problem. An OK tone that still carries an icon and
      // a word, so it never reads by colour alone (a11y).
      status: presentStatus({ tone: 'ok', icon: '🔒', label: t('dayLabel'), announcement: `${t('dayLabel')} ${r.tradingDay}`, needsAttention: false }),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(DAY_REOPEN_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayReopen = ports.mayReopen();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayReopen);
      }

      const worklist = ports.worklist();
      // Most recent trading day first — the one most likely to need a correction.
      const locked = worklist.locked
        .slice()
        .sort((a, b) => (a.tradingDay < b.tradingDay ? 1 : a.tradingDay > b.tradingDay ? -1 : 0))
        .map((r) => present(lang, r));
      const state = locked.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        locked,
        lockedCount: locked.length,
        nobodyNamed,
        mayReopen,
      };
    },

    // Reopen a locked day. Refuse BEFORE any POST — no permission, no reason, no named approver, or the
    // reopener naming THEMSELVES as the approver (§28) is a local refusal, not a round trip. The box still
    // enforces §28 and the cloud re-verifies the approver's authority; the screen never sends a self-approval.
    reopen: async (dayCloseId, reason, approverId) => {
      if (!ports.mayReopen()) return 'refused';
      const trimmedReason = reason.trim();
      const trimmedApprover = approverId.trim();
      if (trimmedReason === '') return 'reason_required';
      if (trimmedApprover === '') return 'approver_required';
      if (config.userId !== null && trimmedApprover === config.userId) return 'refused_self_approval'; // §28
      const row = ports.worklist().locked.find((r) => r.dayCloseId === dayCloseId);
      if (row === undefined) return 'refused';
      return ports.reopenPort().post({ dayCloseId, reason: trimmedReason, approvedBy: trimmedApprover });
    },

    presentReopenResult: (lang, result) => {
      const t = translator(DAY_REOPEN_COPY, lang);
      if (result === 'reopened') return presentStatus({ tone: 'ok', icon: '✓', label: t('reopenRecorded'), needsAttention: false });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('reopenLostLink'), needsAttention: true });
      const label = result === 'refused_self_approval' ? t('reopenSelf')
        : result === 'reason_required' ? t('reopenReasonRequired')
        : result === 'approver_required' ? t('reopenApproverRequired')
        : t('reopenRefused');
      return presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
    },
  };
}
