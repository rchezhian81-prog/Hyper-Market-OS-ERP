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
import { wallClockIn } from '../../../packages/calendar/src/trading-day';
import { DEFAULT_SHOP_CALENDAR } from '../../../packages/calendar/src/shop-clock';

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

/**
 * Round 8 · OB-531: where the roster on screen came from.
 *   • `head_office` — head office's live answer (the default; the only source the assign action is offered on);
 *   • `loading` — head office has not answered yet: nothing is shown as "no gaps";
 *   • `box_copy` — head office cannot be reached, and this is the STORE COMPUTER'S COPY from the signed pack, read-only,
 *     said with when head office last sent it and how old it is (P-08); editing still needs head office;
 *   • `unreachable` — head office cannot be reached and the store computer holds no copy: said, never an empty roster;
 *   • `refused` — head office answered and refused this person the roster: said, never an empty roster (and no copy shown).
 */
export type RosterSource = 'head_office' | 'loading' | 'box_copy' | 'unreachable' | 'refused';

export interface RosteringConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
  /** OB-531: where the roster came from (absent = head office's live answer, as before). */
  readonly source?: RosterSource;
  /** OB-531: when head office last sent the store computer's copy (only for `box_copy`). */
  readonly heldAsAt?: string;
  /** The moment "how old" is measured from (tests pass it; else the clock). */
  readonly now?: () => string;
  /** The shop's time zone for the times shown (default the shop calendar's). */
  readonly timeZone?: string;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'gapsHeading' | 'gapCount' | 'allStaffed' | 'notKnown'
  | 'shiftLabel' | 'roleLabel' | 'shortLabel' | 'nobodyWord' | 'shortWord'
  | 'assignHeading' | 'whoLabel' | 'assignBtn' | 'noEligible'
  | 'assignRecorded' | 'assignRefused' | 'assignLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noManage'
  | 'nobodyNamed' | 'staleShell' | 'sampleData'
  | 'loading' | 'heldCopy' | 'heldReadOnly' | 'unreachableNoCopy' | 'rotaHeading' | 'nobodyOnShift'
  | 'ageMinutes' | 'ageHours' | 'ageDays' | 'ageJustNow' | 'hoRefused';

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
    loading: 'Reading the roster from head office…',
    heldCopy: 'Head office cannot be reached. This is the STORE COMPUTER\'S COPY of the roster, as head office last sent it at {time} ({age}). It may be out of date.',
    heldReadOnly: 'Read-only: changing the roster needs head office. Try again when the connection is back.',
    unreachableNoCopy: 'Head office cannot be reached, and this store computer holds no copy of the roster yet — so it cannot say what is short. Nothing is shown as covered.',
    rotaHeading: 'The rota on the store computer\'s copy', nobodyOnShift: 'nobody on it yet',
    ageMinutes: '{n} minute(s) old', ageHours: '{n} hour(s) old', ageDays: '{n} day(s) old', ageJustNow: 'just now',
    hoRefused: 'Head office refused to show you the roster. Nothing is shown as covered.',
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
    loading: 'தலைமை அலுவலகத்திலிருந்து பணிப்பட்டியலைப் படிக்கிறது…',
    heldCopy: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. இது பணிப்பட்டியலின் கடைக் கணினி நகல் — தலைமை அலுவலகம் கடைசியாக {time} அன்று அனுப்பியது ({age}). இது பழையதாக இருக்கலாம்.',
    heldReadOnly: 'படிக்க மட்டும்: பணிப்பட்டியலை மாற்றத் தலைமை அலுவலகம் தேவை. இணைப்பு திரும்பியதும் மீண்டும் முயற்சிக்கவும்.',
    unreachableNoCopy: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை; இந்தக் கடைக் கணினியில் பணிப்பட்டியல் நகல் இன்னும் இல்லை — எனவே என்ன குறைவு என்று சொல்ல முடியாது. எதுவும் நிரப்பப்பட்டதாகக் காட்டப்படவில்லை.',
    rotaHeading: 'கடைக் கணினி நகலில் உள்ள பணி முறை', nobodyOnShift: 'இன்னும் யாரும் இல்லை',
    ageMinutes: '{n} நிமிடம் பழையது', ageHours: '{n} மணி நேரம் பழையது', ageDays: '{n} நாள் பழையது', ageJustNow: 'இப்போதுதான்',
    hoRefused: 'தலைமை அலுவலகம் உங்களுக்குப் பணிப்பட்டியலைக் காட்ட மறுத்தது. எதுவும் நிரப்பப்பட்டதாகக் காட்டப்படவில்லை.',
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
  /** Whether to offer the assign action — this user holds `workforce.roster.manage` AND the roster is head office's live one. */
  readonly mayManage: boolean;
  /** OB-531: where the roster came from. */
  readonly source: RosterSource;
  /** OB-531: for the store computer's copy — "Head office cannot be reached. This is the store computer's copy … at <time> (<age>)". */
  readonly heldWords: string;
  /** OB-531: why nothing can be changed from here right now ('' when head office answered). */
  readonly readOnlyWords: string;
  /** OB-531: the rota on the store computer's copy, from today on — each shift and who is on it (empty unless `box_copy`). */
  readonly rota: readonly { readonly shiftId: string; readonly startsAt: string; readonly when: string; readonly people: string }[];
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

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayManage: boolean, source: RosterSource = 'head_office', readOnlyWords = ''): RosteringView => ({
  screenState, gaps: [], gapCount: 0, nobodyNamed, mayManage, source, heldWords: '', readOnlyWords, rota: [],
});

/** OB-531: how old the store computer's copy is, in words. */
export function rosterAgeWords(lang: Lang, asAt: string, nowIso: string): string {
  const t = translator(ROSTERING_COPY, lang);
  const minutes = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(asAt)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return t('ageJustNow');
  if (minutes < 120) return t('ageMinutes').replace('{n}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t('ageHours').replace('{n}', String(hours));
  return t('ageDays').replace('{n}', String(Math.floor(hours / 24)));
}

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

  const source: RosterSource = config.source ?? 'head_office';
  const live = source === 'head_office';
  const now = config.now ?? (() => new Date().toISOString());
  const zone = config.timeZone ?? DEFAULT_SHOP_CALENDAR.timeZone;
  const shown = (iso: string): string => { try { return wallClockIn(iso, zone).replace('T', ' '); } catch { return iso; } };

  return {
    text,
    view: (lang) => {
      const t = translator(ROSTERING_COPY, lang);
      const nobodyNamed = config.userId === null;
      // OB-531: the assign action is offered ONLY on head office's live roster — the store computer's copy is read-only.
      const mayManage = live && ports.mayManage();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayManage);
      }
      // OB-531 · P-08: never "no gaps" before head office answers, nor when it cannot be reached and there is no copy.
      if (source === 'loading') return EMPTY_VIEW(presentScreenState({ state: 'loading', label: t('loading') }), nobodyNamed, false, source);
      if (source === 'unreachable') return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('unreachableNoCopy') }), nobodyNamed, false, source, t('heldReadOnly'));
      if (source === 'refused') return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('hoRefused') }), nobodyNamed, false, source);

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
      const held = source === 'box_copy' && config.heldAsAt !== undefined;
      const names = new Map(data.employees.map((e) => [e.employeeId, e.name.trim() === '' ? e.employeeId : e.name.trim()]));
      const today = shown(now()).slice(0, 10);
      const rota = !held ? [] : data.shifts
        .filter((s) => shown(s.endsAt).slice(0, 10) >= today)
        .slice()
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.shiftId.localeCompare(b.shiftId))
        .map((s) => {
          const on = data.assignments.filter((a) => a.shiftId === s.shiftId).map((a) => `${names.get(a.employeeId) ?? a.employeeId} (${a.role})`);
          return { shiftId: s.shiftId, startsAt: s.startsAt, when: `${shown(s.startsAt)} – ${shown(s.endsAt).slice(11)}`, people: on.length === 0 ? t('nobodyOnShift') : on.join(', ') };
        });
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        gaps,
        gapCount: gaps.length,
        nobodyNamed,
        mayManage,
        source,
        heldWords: held ? t('heldCopy').replace('{time}', shown(config.heldAsAt!)).replace('{age}', rosterAgeWords(lang, config.heldAsAt!, now())) : '',
        readOnlyWords: live ? '' : t('heldReadOnly'),
        rota,
      };
    },

    // Assign a person to a shift. Refuse BEFORE any POST — no permission, or an ineligible person (not active /
    // lacks the role / already on the shift for that role) is a local refusal, not a round trip. The server
    // re-checks the permission and records the assignment in the manager's own name.
    assign: async (shiftId, employeeId, role) => {
      // OB-531: nothing is changed from the store computer's copy — editing the roster needs head office.
      if (!live || !ports.mayManage()) return 'refused';
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
