// The manager ROSTERING screen — the "who is on, and what is the roster short" desk (M25-FR-01 · API-11 ·
// P-03 control-by-exception · P-04 least privilege · P-08 no silent failure). The durable roster store
// (services/finance/src/roster-store.ts) holds the staff directory, the shifts and the assignments; the cloud
// folds them and runs the tested `rosterGaps` engine into a worklist (`GET /v1/hr/workforce/roster-gaps`). This
// is the screen a manager works it from: every gap the roster has — worst first — and the one action taken from
// here, ASSIGN a person to the short shift, in the manager's own name.
//
// Truths the surface must carry, all already true in the engine and re-stated so the screen cannot weaken them:
//   • **A gap is per role per shift, in words a manager acts on** (P-03). "Sunday 06:00 has NOBODY rostered as
//     cashier" outranks "2 short of picker" — an unstaffed role (nobody at all) is the worst kind and is shown
//     as an error tone, a partial shortfall as a warning; colour is never the only signal (icon + word ride with
//     every tone). A leaver still on the grid is not cover — the engine already excludes them, so a gap the eye
//     misses is surfaced here.
//   • **Assigning needs the manage permission** (§28 / P-04 least privilege). A viewer with only
//     `workforce.roster.read` sees the gaps but is offered no assign control; the write needs
//     `workforce.roster.manage`, enforced here AND at the cloud route. Nobody is rostered automatically — this
//     records what a manager decided (hard rule #5: no AI writes a roster).
//   • **Only an eligible person can fill a gap.** The screen offers, for each gap, the ACTIVE staff who hold
//     that role and are not already on that shift for it; an ineligible assignment is refused before any POST.
//   • **It self-heals.** The worklist is re-READ from the cloud, so a filled gap drops off on its own; this
//     screen never carries a "done" flag that can go stale against reality. And a roster the box was never told
//     is `not known`, never "no gaps" (P-08).
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives; the shell only renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { Employee, ShiftRequirement, ShiftAssignment, RosterGap } from '../../../packages/workforce/src/workforce';

/** The roster worklist the shell last read: the gaps (from the cloud's `rosterGaps` fold) plus the roster
 *  CONTEXT the screen needs to offer who can fill each gap. Absent/`known:false` means the box was never told. */
export interface RosteringData {
  readonly gaps: readonly RosterGap[];
  readonly employees: readonly Employee[];
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
}

/** The outcome of an assignment — recorded, refused by the server (permission / ineligible), or a lost link. */
export type AssignResult = 'assigned' | 'refused' | 'lost_link';

/** The authenticated POST of a manager's assignment. Injected, so the model never opens a socket itself; the
 *  server records it in the caller's own name (`POST /v1/hr/workforce/shifts/:shiftId/assignments/:employeeId`)
 *  and re-checks `workforce.roster.manage`. */
export interface AssignPort {
  post(input: { readonly shiftId: string; readonly employeeId: string; readonly role: string }): Promise<AssignResult>;
}

export interface RosteringPorts {
  /** The roster worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): RosteringData;
  /** Whether this user may read the roster (`workforce.roster.read`). */
  mayRead(): boolean;
  /** Whether this user may assign staff to shifts (`workforce.roster.manage`). */
  mayManage(): boolean;
  /** Records an assignment. Only reached from the explicit action, never on render. */
  assignPort(): AssignPort;
}

export interface RosteringConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'gapsHeading' | 'gapCount' | 'allStaffed' | 'notKnown'
  | 'shiftLabel' | 'roleLabel' | 'shortLabel' | 'nobodyWord' | 'shortWord'
  | 'assignHeading' | 'whoLabel' | 'assignBtn' | 'noEligible'
  | 'assignRecorded' | 'assignRefused' | 'assignLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noManage'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const ROSTERING_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Roster gaps', langName: 'தமிழ்',
    lead: 'Shifts the roster cannot run as it stands — worst first — waiting for a manager to fill them. A shift with NOBODY in a required role outranks one that is just short. A person who has left is not cover, even if their name is still on the grid. Assigning records who you put on, in your name; nothing is rostered automatically.',
    gapsHeading: 'To fill', gapCount: 'to fill', allStaffed: 'No gaps — every required role on every shift is covered.',
    notKnown: 'This store computer has not been told the roster yet, so it cannot say what is short.',
    shiftLabel: 'Shift', roleLabel: 'Role', shortLabel: 'Short by',
    nobodyWord: 'Nobody', shortWord: 'Short',
    assignHeading: 'Put someone on a short shift', whoLabel: 'Who to put on', assignBtn: 'Assign to the shift',
    noEligible: 'Nobody active holds this role who is not already on this shift — this gap cannot be filled from here.',
    assignRecorded: 'Assigned.',
    assignRefused: 'Could not assign — the person must be active, hold the role, and not already be on the shift; or you do not have permission to change the roster.',
    assignLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the roster gaps', scrEmpty: 'No gaps — every required role on every shift is covered.',
    stateNotPermitted: 'You do not have permission to see the roster.',
    noManage: 'You can see the gaps, but changing the roster needs manager permission.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'பணிப்பட்டியல் இடைவெளிகள்', langName: 'English',
    lead: 'தற்போதைய நிலையில் நடத்த முடியாத ஷிப்டுகள் — மோசமானது முதலில் — மேலாளர் நிரப்பக் காத்திருக்கின்றன. ஒரு தேவையான பணியில் யாருமே இல்லாத ஷிப்ட், சற்றே குறைவான ஒன்றை விட முன்னிடம் பெறும். வெளியேறியவர் பட்டியலில் இருந்தாலும் அவர் ஆள் அல்ல. ஒதுக்கீடு நீங்கள் யாரை வைத்தீர்கள் என்பதை உங்கள் பெயரில் பதிவு செய்கிறது; எதுவும் தானாக ஒதுக்கப்படாது.',
    gapsHeading: 'நிரப்ப வேண்டியவை', gapCount: 'நிரப்ப', allStaffed: 'இடைவெளி இல்லை — ஒவ்வொரு ஷிப்டிலும் தேவையான பணிகள் அனைத்தும் நிரப்பப்பட்டுள்ளன.',
    notKnown: 'பணிப்பட்டியல் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை, எனவே என்ன குறைவு என்று சொல்ல முடியாது.',
    shiftLabel: 'ஷிப்ட்', roleLabel: 'பணி', shortLabel: 'குறைவு',
    nobodyWord: 'யாரும் இல்லை', shortWord: 'குறைவு',
    assignHeading: 'குறைவான ஷிப்டில் ஒருவரை வை', whoLabel: 'யாரை வைப்பது', assignBtn: 'ஷிப்டில் ஒதுக்கு',
    noEligible: 'இந்தப் பணியை வகிக்கும், இந்த ஷிப்டில் ஏற்கனவே இல்லாத, செயலில் உள்ள ஆள் யாரும் இல்லை — இந்த இடைவெளியை இங்கிருந்து நிரப்ப முடியாது.',
    assignRecorded: 'ஒதுக்கப்பட்டது.',
    assignRefused: 'ஒதுக்க முடியவில்லை — நபர் செயலில் இருக்க வேண்டும், பணியை வகிக்க வேண்டும், ஏற்கனவே ஷிப்டில் இருக்கக்கூடாது; அல்லது பணிப்பட்டியலை மாற்ற உங்களுக்கு அனுமதி இல்லை.',
    assignLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'பணிப்பட்டியல் இடைவெளிகளைக் காட்டுகிறது', scrEmpty: 'இடைவெளி இல்லை — ஒவ்வொரு ஷிப்டிலும் தேவையான பணிகள் அனைத்தும் நிரப்பப்பட்டுள்ளன.',
    stateNotPermitted: 'பணிப்பட்டியலைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    noManage: 'இடைவெளிகளைப் பார்க்கலாம், ஆனால் பணிப்பட்டியலை மாற்ற மேலாளர் அனுமதி தேவை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(ROSTERING_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

/** One person who could fill a gap — active, holds the role, not already on that shift for it. */
export interface EligibleStaff {
  readonly employeeId: string;
  /** The name if the box has it, else the id — never blank. */
  readonly label: string;
}

export interface PresentedGap {
  readonly shiftId: string;
  readonly role: string;
  readonly startsAt: string;
  readonly needed: number;
  readonly assigned: number;
  readonly short: number;
  /** "Nobody" (assigned === 0) vs "Short" — a word, never colour alone. */
  readonly severityWord: string;
  /** The manager-readable sentence from the engine. */
  readonly detail: string;
  /** Active staff who hold the role and are not already on this shift — who this gap can be filled with. */
  readonly eligible: readonly EligibleStaff[];
  /** Every gap needs attention (P-03); an unstaffed role is an error tone, a partial shortfall a warning. */
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
}

export interface RosteringView {
  readonly screenState: StatusPresentation;
  readonly gaps: readonly PresentedGap[];
  readonly gapCount: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the assign action — this user holds `workforce.roster.manage`. */
  readonly mayManage: boolean;
}

export interface RosteringSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): RosteringView;
  /** Assign a person to a shift as a role, in the manager's name — a HUMAN write. Runs only from an explicit
   *  action, never on render; refuses BEFORE any POST without permission or when the person is not eligible
   *  (inactive / lacks the role / already on the shift — the server re-checks permission too). */
  assign(shiftId: string, employeeId: string, role: string): Promise<AssignResult>;
  /** Present an assignment outcome as one glanceable status the shell shows after the action. */
  presentAssignResult(lang: Lang, result: AssignResult): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayManage: boolean): RosteringView => ({
  screenState, gaps: [], gapCount: 0, nobodyNamed, mayManage,
});

export function createRosteringSession(config: RosteringConfig, ports: RosteringPorts): RosteringSession {
  const text = (lang: Lang, key: CopyKey): string => translator(ROSTERING_COPY, lang)(key);

  /** The active staff who could fill this gap: hold the role, and are not already on this shift for that role. */
  const eligibleFor = (gap: RosterGap, data: RosteringData): EligibleStaff[] => {
    const onShiftForRole = new Set(
      data.assignments.filter((a) => a.shiftId === gap.shiftId && a.role === gap.role).map((a) => a.employeeId),
    );
    return data.employees
      .filter((e) => e.active && e.roles.includes(gap.role) && !onShiftForRole.has(e.employeeId))
      .map((e) => ({ employeeId: e.employeeId, label: e.name.trim() === '' ? e.employeeId : e.name.trim() }));
  };

  const present = (lang: Lang, gap: RosterGap, data: RosteringData): PresentedGap => {
    const t = translator(ROSTERING_COPY, lang);
    // An unstaffed role (nobody at all) is the worst kind — an error tone; a partial shortfall is a warning.
    const nobody = gap.assigned === 0;
    const severityWord = t(nobody ? 'nobodyWord' : 'shortWord');
    return {
      shiftId: gap.shiftId,
      role: gap.role,
      startsAt: gap.startsAt,
      needed: gap.needed,
      assigned: gap.assigned,
      short: gap.short,
      severityWord,
      detail: gap.detail,
      eligible: eligibleFor(gap, data),
      status: presentStatus({
        tone: nobody ? 'error' : 'degraded',
        icon: nobody ? '✕' : '⚠',
        label: `${severityWord} · ${gap.role}`,
        announcement: gap.detail,
        needsAttention: true,
      }),
      needsAttention: true,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(ROSTERING_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayManage = ports.mayManage();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayManage);
      }

      const data = ports.worklist();
      // Worst first: an unstaffed role (assigned 0) before a partial shortfall; then the larger shortfall; then
      // the earlier shift, so the next thing to open the shop for is at the top. The engine already sorts by
      // start time; this layers the severity that a manager acts on first (P-03).
      const gaps = data.gaps
        .slice()
        .sort((a, b) =>
          (a.assigned === 0 ? 0 : 1) - (b.assigned === 0 ? 0 : 1) ||
          b.short - a.short ||
          a.startsAt.localeCompare(b.startsAt),
        )
        .map((gap) => present(lang, gap, data));
      const state = gaps.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        gaps,
        gapCount: gaps.length,
        nobodyNamed,
        mayManage,
      };
    },

    // Assign a person to a shift. Refuse BEFORE any POST — no permission, or an ineligible person (not active /
    // lacks the role / already on the shift for that role) is a local refusal, not a round trip. The server
    // re-checks the permission and records the assignment in the manager's own name.
    assign: async (shiftId, employeeId, role) => {
      if (!ports.mayManage()) return 'refused';
      const data = ports.worklist();
      const gap = data.gaps.find((g) => g.shiftId === shiftId && g.role === role);
      if (gap === undefined) return 'refused'; // not a shift/role the roster is short of
      const eligible = eligibleFor(gap, data).some((e) => e.employeeId === employeeId);
      if (!eligible) return 'refused';
      return ports.assignPort().post({ shiftId, employeeId, role });
    },

    presentAssignResult: (lang, result) => {
      const t = translator(ROSTERING_COPY, lang);
      if (result === 'assigned') return presentStatus({ tone: 'ok', icon: '✓', label: t('assignRecorded'), needsAttention: false });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('assignLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('assignRefused'), needsAttention: true });
    },
  };
}
